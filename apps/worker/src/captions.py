"""YouTube captions as a lyrics text source — HUMAN-AUTHORED tracks only.

WHY THIS TIER EXISTS. A lyrics database is indexed by artist+track, so it can only ever answer with a
record for *a* recording of that song and hope it is the one you downloaded. Captions are attached to
the EXACT upload being sung over, which makes them the only source that cannot be about a different
version. For a song with two popular releases that is a strong signal, not a marginal one.

WHY AUTO-GENERATED CAPTIONS ARE REFUSED OUTRIGHT. YouTube's automatic captions are ASR — the same
class of guess the local Whisper tier already produces, and produced from the MIXED audio rather than
from an isolated vocals stem, so they are strictly worse than what this worker computes for itself.
Worse, they arrive wearing a caption's clothes: accepted as "captions" they would be treated as
authoritative text and could outrank a correct database lookup. This is a documented trap — see
`textConfidence` on LyricsCandidate in packages/shared/src/lyrics.ts, which exists precisely to demote
them.

The refusal is STRUCTURAL rather than a check. `caption_argv` passes `--write-subs` and never
`--write-auto-subs`, so yt-dlp will not produce an automatic track at all; there is no auto-generated
file to accidentally read. A filename-based filter would be a second, weaker line of defence against a
file that cannot exist, so there isn't one.

PURE of network and subprocess by construction: parsing is a free function over text, argv is a list,
and the one I/O class takes an injected runner — so the whole tier unit-tests with a fake.
"""
from __future__ import annotations

import os
import re
from typing import Any, Iterable

#: Caption languages worth asking for, best-first. Kept narrow deliberately: a lyrics track in a
#: language the aligner is not running on would align badly and score as a mismatch anyway.
DEFAULT_SUB_LANGS = "en.*,en"

# A WebVTT cue timing line: "00:01:23.456 --> 00:01:25.000 align:start position:0%".
# Hours are optional in the spec ("01:23.456"), so the leading group is conditional.
_VTT_TIME = r"(?:(\d{1,3}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})"
_VTT_CUE_RE = re.compile(rf"^{_VTT_TIME}\s*-->\s*{_VTT_TIME}")

#: Inline caption markup: <c.colorE5E5E5>, <00:00:12.345>, <b>, </i>. Karaoke-style per-word timing
#: tags are common in auto tracks and harmless to strip here — this tier only claims LINE timing.
_TAG_RE = re.compile(r"<[^>]*>")

#: Bracketed non-lyric annotations captioners add: [Music], [Applause], (chorus), ♪♪.
_ANNOTATION_RE = re.compile(r"^\s*(?:[\[(][^\])]*[\])]|[♪♫\s]+)\s*$")


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

    Handles the parts real YouTube tracks actually contain: an optional cue identifier line before the
    timing, cue settings after it, inline markup, and NOTE/STYLE/REGION blocks. Cues whose payload is
    only an annotation ([Music]) are dropped — they are not lyrics, and feeding them to a forced
    aligner corrupts the words on either side.

    CONSECUTIVE DUPLICATES ARE COLLAPSED. Caption tracks routinely repeat a line across cues to hold it
    on screen, and a rolling track repeats it with each new cue. Left in, the same line would be
    aligned several times and the transcript would score its own text as far more repetitive than the
    vocals are.
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
        while i < len(lines) and lines[i].strip() and _VTT_CUE_RE.match(lines[i].strip()) is None:
            payload.append(lines[i])
            i += 1
        body = _clean_cue_text(payload)
        if not body or end <= start:
            continue
        if out and out[-1]["text"] == body:
            out[-1]["end"] = max(out[-1]["end"], end)  # held-on-screen repeat, not a new line
            continue
        out.append({"start": start, "end": end, "text": body})
    out.sort(key=lambda s: s["start"])
    return out


def caption_argv(
    source_uri: str, out_template: str, ytdlp_bin: str = "yt-dlp", langs: str = DEFAULT_SUB_LANGS
) -> list[str]:
    """yt-dlp argv fetching ONLY human-authored subtitle tracks, and no media.

    `--write-subs` without `--write-auto-subs` is the whole guarantee of this tier: yt-dlp writes a
    file only when the uploader supplied a real caption track, and an ASR track is never requested.
    Adding `--write-auto-subs` here would silently turn an authoritative source into a second,
    worse-quality ASR tier.

    `--skip-download` keeps this cheap enough to attempt on every align job — it is a metadata request,
    not a second download of audio the worker already has.
    """
    return [
        ytdlp_bin,
        "--skip-download",
        "--write-subs",
        "--sub-langs",
        langs,
        "--sub-format",
        "vtt/srt/best",
        "--convert-subs",
        "vtt",
        "--no-playlist",
        "--no-warnings",
        "-o",
        out_template,
        source_uri,
    ]


def find_caption_file(directory: str) -> str | None:
    """The caption file yt-dlp wrote, or None. Prefers a plain `en` track over a regional variant
    (`en-GB`, `en-US`) only to be deterministic; either is equally authoritative."""
    try:
        names = sorted(os.listdir(directory))
    except OSError:
        return None
    subs = [n for n in names if n.endswith((".vtt", ".srt"))]
    if not subs:
        return None
    subs.sort(key=lambda n: (0 if ".en." in n else 1, len(n), n))
    return os.path.join(directory, subs[0])


def read_captions(directory: str) -> list[dict[str, Any]]:
    """Whatever caption track landed in `directory`, parsed. [] when none did.

    Deliberately NOT a subprocess call. The fetch runs through the align processor's own injected
    runner — the same one the audio download uses — so this module owns no second, un-injectable path
    to yt-dlp and the whole tier stays fake-able from the existing test harness. An earlier draft ran
    yt-dlp itself and silently made every processor test shell out to the network.
    """
    path = find_caption_file(directory)
    if path is None:
        return []
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return parse_vtt(f.read())
    except OSError:
        return []
