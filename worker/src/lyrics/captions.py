"""YouTube captions as a lyrics text source — HUMAN-AUTHORED tracks only.

WHY THIS TIER EXISTS: a lyrics database can only answer with *a* recording of a song, but captions
are attached to the EXACT upload being sung over, so they cannot be about a different version.

TWO KINDS, OPPOSITE ROLES. An uploader-authored track is a CANDIDATE for the song's words. YouTube's
automatic track is a BASELINE (evidence of what is audible), barred from being the answer while any
candidate is trustworthy — treated as authored text it is actively dangerous (ASR on the MIXED
audio, worse than this worker's own vocals-stem transcription, that could outrank a correct database
lookup). It is typically a WEAK baseline opinion, but a baseline that thin abstains rather than voting.

The two kinds are kept apart STRUCTURALLY: `caption_argv` requests exactly one kind per call into
separate directories, since yt-dlp names both identically.

PURE of network and subprocess by construction: parsing is a free function over text, argv is a
list, and the fetch runs through the align processor's own injected runner.
"""

from __future__ import annotations

import os
import re
from collections.abc import Iterable
from typing import Any

#: Best-first. EXPLICIT CODES, NEVER A PATTERN: `en.*` matches every one of YouTube's ~190
#: `en-<source>` translation codes, firing dozens of requests per job and earning a 429 — wasted anyway,
#: since `find_caption_file` refuses translations. `en-orig` leads as the only guaranteed non-translation.
DEFAULT_SUB_LANGS = "en-orig,en,en-US,en-GB"

#: Before EACH subtitle download: the requests are what YouTube rate-limits.
SUB_SLEEP_SEC = 1

#: Exponential from 1s, capped at 30s. Without it yt-dlp gives a rate-limited track exactly one chance,
#: turning a transient 429 into a permanently missing baseline.
HTTP_RETRY_SLEEP = "http:exp=1:30"

#: Ahead of any track download: a 429 on the player request loses EVERY track at once.
EXTRACTOR_RETRIES = 3

# Hours are OPTIONAL in the spec ("01:23.456"), so the leading group is conditional.
_VTT_TIME = r"(?:(\d{1,3}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})"
_VTT_CUE_RE = re.compile(rf"^{_VTT_TIME}\s*-->\s*{_VTT_TIME}")

#: Per-word timing tags are common in auto tracks and harmless to strip: this tier claims LINE timing.
_TAG_RE = re.compile(r"<[^>]*>")

#: Bracketed non-lyric annotations captioners add: [Music], [Applause], (chorus), ♪♪.
_ANNOTATION_RE = re.compile(r"^\s*(?:[\[(][^\])]*[\])]|[♪♫\s]+)\s*$")

#: A small non-zero slack absorbs float rounding without reaching across the gap to a chorus line that
#: recurs later in the song.
_ROLLING_ADJACENCY_SEC = 0.5

#: YouTube's rolling window does not only grow, it SCROLLS: once full, words drop off the FRONT, so a
#: line's HEAD repeats the previous line's TAIL rather than growing as a prefix — a shape the
#: prefix-extend fold cannot reach. Load-bearing, because time-adjacency alone cannot separate a genuine
#: scroll from a coincidental shared word.
_SCROLL_MIN_OVERLAP_WORDS = 3


def _head_tail_overlap_words(prev: str, incoming: str) -> int:
    """Words of `incoming`'s HEAD that repeat `prev`'s TAIL: the longest suffix of `prev` that is a
    prefix of `incoming`, counted in whole words. 0 when they do not meet on a word boundary.

    Word granularity, not characters, on purpose — the window scrolls by whole words, and a character
    measure would false-match a shared word fragment across a real boundary.
    """
    a, b = prev.split(), incoming.split()
    for k in range(min(len(a), len(b)), 0, -1):
        if a[-k:] == b[:k]:
            return k
    return 0


def _collapse_scroll_overlap(segs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Trim the repeated head off each SCROLL line, leaving one window per real line.

    Runs AFTER `parse_vtt`'s held/prefix-extend fold, which this leaves untouched. TRIMMING rather
    than merging preserves per-line windows the forced aligner and word-level highlighting both
    consume.

    Iterated to a FIXPOINT: a scrolled cue's text can carry the repeated phrase TWICE, which one
    left-to-right pass only removes once. The time-adjacency bound means a chorus line recurring
    LATER in the song is never trimmed against an earlier one.
    """
    while True:
        result: list[dict[str, Any]] = []
        for seg in segs:
            adjacent = bool(result) and seg["start"] <= result[-1]["end"] + _ROLLING_ADJACENCY_SEC
            # A non-adjacent cue scores 0 and so takes the not-a-scroll path below: time adjacency is a
            # precondition of the overlap meaning anything, not a separate decision.
            overlap = _head_tail_overlap_words(result[-1]["text"], seg["text"]) if adjacent else 0
            if overlap < _SCROLL_MIN_OVERLAP_WORDS:
                result.append(dict(seg))
                continue
            tail = " ".join(seg["text"].split()[overlap:]).strip()
            if not tail:
                # Wholly contained in the running line's tail, a pure re-hold.
                result[-1]["end"] = max(result[-1]["end"], seg["end"])
                continue
            result.append({"start": seg["start"], "end": seg["end"], "text": tail})
        if result == segs:
            return result
        segs = result


def _cue_seconds(hh: str | None, mm: str, ss: str, frac: str) -> float:
    total = int(mm) * 60 + int(ss)
    if hh:
        total += int(hh) * 3600
    return round(total + float(f"0.{frac}"), 3)


def _clean_cue_text(lines: Iterable[str]) -> str:
    """Cue payload → one displayable line. Markup stripped, annotation-only cues emptied."""
    parts: list[str] = []
    for raw in lines:
        t = _TAG_RE.sub("", raw).strip()
        if not t or _ANNOTATION_RE.match(t):
            continue
        parts.append(t)
    return " ".join(parts).strip()


def parse_vtt(text: str) -> list[dict[str, Any]]:
    """WebVTT (or SRT — the cue grammar overlaps enough) → [{start, end, text}], time-sorted.

    Handles an optional cue identifier line before the timing, cue settings after it, inline markup,
    and NOTE/STYLE/REGION blocks. Cues whose payload is only an annotation ([Music]) are dropped:
    feeding them to a forced aligner corrupts the words on either side.

    A PAYLOAD ENDS AT A GENUINELY EMPTY LINE, not a whitespace-only one: a whitespace-only line is
    legal *inside* a payload, and YouTube's auto tracks open the word-timed cue of each rolling
    triplet with exactly such a line — ending on `.strip()` being falsy would discard that whole cue.

    ROLLING AND HELD DUPLICATES ARE COLLAPSED, or a rolling track parses to roughly double the real
    lines. YouTube's auto tracks *roll*: each cue repeats the previous cue's text plus a few new
    words, so held/prefix-extend duplicates fold into one line here, keeping the longest text. A
    rolling window also SCROLLS (the HEAD repeats the previous line's TAIL instead of growing as a
    prefix) — that shape is trimmed separately by `_collapse_scroll_overlap`.

    Both mechanisms are bounded by TIME-ADJACENCY, so a chorus line that genuinely recurs later in
    the song is never folded into an earlier one.
    """
    out: list[dict[str, Any]] = []
    lines = (text or "").replace("\r\n", "\n").replace("\r", "\n").split("\n")
    i = 0
    while i < len(lines):
        m = _VTT_CUE_RE.match(lines[i].strip())
        if m is None:
            i += 1
            continue
        start = _cue_seconds(m.group(1), m.group(2), m.group(3), m.group(4))
        end = _cue_seconds(m.group(5), m.group(6), m.group(7), m.group(8))
        i += 1
        payload: list[str] = []
        # A literally EMPTY line or the next cue's timing, never a whitespace-only one, which is legal
        # inside a payload and opens the word-timed cue of a rolling triplet.
        while i < len(lines) and lines[i] != "" and _VTT_CUE_RE.match(lines[i].strip()) is None:
            payload.append(lines[i])
            i += 1
        body = _clean_cue_text(payload)
        if not body or end <= start:
            continue
        if (
            out
            and start <= out[-1]["end"] + _ROLLING_ADJACENCY_SEC
            and (body == out[-1]["text"] or body.startswith(out[-1]["text"]))
        ):
            # Held repeat or rolling extend: fold into the run, keeping the longest text.
            out[-1]["text"] = body
            out[-1]["end"] = max(out[-1]["end"], end)
            continue
        out.append({"start": start, "end": end, "text": body})
    out.sort(key=lambda s: s["start"])
    # The fold above catches HELD and PREFIX-EXTEND only, so a second pass trims a scrolled overlap.
    return _collapse_scroll_overlap(out)


def caption_argv(
    source_uri: str,
    out_template: str,
    ytdlp_bin: str = "yt-dlp",
    *,
    auto: bool = False,
) -> list[str]:
    """yt-dlp argv fetching ONE KIND of subtitle track, and no media.

    `auto=False` fetches only uploader-authored tracks; `auto=True` fetches only YouTube's
    machine-generated ones. Never both in one call, and the caller writes them to SEPARATE
    directories — the whole guarantee that an automatic track (BASELINE) cannot be mistaken for an
    authored one (CANDIDATE), since yt-dlp names them identically.

    `--skip-download` keeps this cheap enough to attempt on every align job. The throttle/retry flags
    exist because this call is rate-limited in practice (YouTube answers a burst of timedtext
    requests with `HTTP Error 429`) and a caption miss here is silent — see the constants above.
    """
    return [
        ytdlp_bin,
        "--skip-download",
        "--write-auto-subs" if auto else "--write-subs",
        "--sub-langs",
        DEFAULT_SUB_LANGS,
        "--sub-format",
        "vtt/srt/best",
        "--convert-subs",
        "vtt",
        "--sleep-subtitles",
        str(SUB_SLEEP_SEC),
        "--retry-sleep",
        HTTP_RETRY_SLEEP,
        "--extractor-retries",
        str(EXTRACTOR_RETRIES),
        "--no-playlist",
        "--no-warnings",
        "-o",
        out_template,
        source_uri,
    ]


#: YouTube exposes a machine translation under the target language with a long opaque suffix.
_TRANSLATED_SUFFIX = re.compile(r"-[A-Za-z0-9_-]{8,}$")

#: A lowercase language subtag after the target (`en-cs`), short enough that `_TRANSLATED_SUFFIX` misses
#: it. Told from a legitimate REGION variant by CASE, per BCP 47: regions are uppercase.
_TRANSLATED_FROM = re.compile(r"-[a-z]{2,3}$")


def is_translated_track(name: str) -> bool:
    """Is this caption filename a machine TRANSLATION rather than the original language?

    Load-bearing for correctness, not tidiness: a Spanish song's automatic captions offered
    translated into English would, as a baseline, be fluent and long enough to clear
    MIN_TOKENS_TO_COMPARE while being about the right song in the WRONG language — so instead of
    abstaining it would vote confidently against every correct candidate, worse than no baseline at all.
    """
    stem = name.rsplit(".", 1)[0]  # drop .vtt / .srt
    lang = stem.rsplit(".", 1)[-1] if "." in stem else stem
    if lang.endswith("-orig"):
        return False
    return bool(_TRANSLATED_SUFFIX.search(lang) or _TRANSLATED_FROM.search(lang))


def find_caption_file(directory: str) -> str | None:
    """The caption file yt-dlp wrote, or None.

    Machine translations are refused outright (see `is_translated_track`). Among what remains, an
    original-language marker wins, then a plain code over a regional variant — purely so the choice is
    deterministic and a re-process cannot silently produce different lyrics.
    """
    try:
        names = sorted(os.listdir(directory))
    except OSError:
        return None
    subs = [n for n in names if n.endswith((".vtt", ".srt")) and not is_translated_track(n)]
    if not subs:
        return None
    subs.sort(key=lambda n: (0 if "-orig." in n else 1, 0 if ".en." in n else 1, len(n), n))
    return os.path.join(directory, subs[0])


def read_captions(directory: str) -> list[dict[str, Any]]:
    """Whatever caption track landed in `directory`, parsed. [] when none did.

    Deliberately NOT a subprocess call: the fetch runs through the align processor's own injected
    runner (the same one the audio download uses), so this module owns no second, un-injectable path
    to yt-dlp and the whole tier stays fake-able from the existing test harness.
    """
    path = find_caption_file(directory)
    if path is None:
        return []
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return parse_vtt(f.read())
    except OSError:
        return []
