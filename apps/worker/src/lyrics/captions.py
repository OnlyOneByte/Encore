"""YouTube captions as a lyrics text source — HUMAN-AUTHORED tracks only.

WHY THIS TIER EXISTS. A lyrics database is indexed by artist+track, so it can only ever answer with a
record for *a* recording of that song and hope it is the one you downloaded. Captions are attached to
the EXACT upload being sung over, which makes them the only source that cannot be about a different
version. For a song with two popular releases that is a strong signal, not a marginal one.

TWO KINDS, OPPOSITE ROLES. An uploader-authored track is a CANDIDATE for the song's words. YouTube's
automatic track is a BASELINE: evidence of what is audible, used to grade candidates, and barred from
being the answer while any candidate is trustworthy.

That split is what makes the automatic track safe to use at all. Treated as authored text it is actively
dangerous — it is ASR wearing a caption's clothes, produced from the MIXED audio (so worse than this
worker's own transcription of an isolated vocals stem), and ranked as authoritative it could outrank a
correct database lookup. As a baseline the same text is just a third opinion on what is audible, which is
all it ever was. Measured across five uploads it is a WEAK opinion — YouTube's ASR suppresses sung vocals
into [Music] markers and was absent or useless on three of the five (a-ha "Take On Me": 8 words plus 15
music cues) — but a baseline that thin abstains rather than voting, so including it costs nothing.

The two kinds are kept apart STRUCTURALLY, not by a filter: `caption_argv` requests exactly one kind per
call (`--write-subs` xor `--write-auto-subs`) and the caller writes them into separate directories.
yt-dlp names both identically, so any single-directory scheme would leave the distinction to a filename
heuristic.

PURE of network and subprocess by construction: parsing is a free function over text, argv is a list,
and the fetch runs through the align processor's own injected runner — so the whole tier unit-tests
with a fake.
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
    source_uri: str,
    out_template: str,
    ytdlp_bin: str = "yt-dlp",
    langs: str = DEFAULT_SUB_LANGS,
    auto: bool = False,
) -> list[str]:
    """yt-dlp argv fetching ONE KIND of subtitle track, and no media.

    `auto=False` passes `--write-subs` and fetches only uploader-authored tracks. `auto=True` passes
    `--write-auto-subs` and fetches only YouTube's machine-generated ones. Never both in one call, and
    the caller writes them to SEPARATE directories — that separation is the whole guarantee that an
    automatic track cannot be mistaken for an authored one downstream.

    It matters because the two have opposite roles. An authored track is a CANDIDATE for the song's
    words; a machine track is a BASELINE, evidence of what is audible, and is barred from ever being the
    answer while a candidate is trustworthy. Requesting both into one directory would leave the
    distinction to a filename heuristic, and yt-dlp names them identically.

    `--skip-download` keeps this cheap enough to attempt on every align job — it is a metadata request,
    not a second download of audio the worker already has.
    """
    return [
        ytdlp_bin,
        "--skip-download",
        "--write-auto-subs" if auto else "--write-subs",
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


#: A TRANSLATED caption track. YouTube exposes machine translations of a caption track under the target
#: language with a long opaque suffix ("en-nP7Qs3xK9dQ"), alongside the original which is either plain
#: ("en") or explicitly marked ("en-orig"). Region variants ("en-GB", "pt-BR") are short and are NOT
#: translations.
_TRANSLATED_SUFFIX = re.compile(r"-[A-Za-z0-9_-]{8,}$")


def is_translated_track(name: str) -> bool:
    """Is this caption filename a machine TRANSLATION rather than the original language?

    Load-bearing for correctness, not tidiness. A Spanish song's automatic captions can be offered
    translated into English; as a baseline that text would be fluent, long enough to pass
    MIN_TOKENS_TO_COMPARE, and about the right song in the WRONG language — so it would not abstain, it
    would vote confidently against every correct candidate. That is worse than having no baseline.
    """
    stem = name.rsplit(".", 1)[0]  # drop .vtt / .srt
    lang = stem.rsplit(".", 1)[-1] if "." in stem else stem
    if lang.endswith("-orig"):
        return False
    return bool(_TRANSLATED_SUFFIX.search(lang))


def find_caption_file(directory: str) -> str | None:
    """The caption file yt-dlp wrote, or None.

    Machine translations are refused outright (see `is_translated_track`). Among what remains, an
    original-language marker wins, then a plain code over a regional variant — purely so the choice is
    deterministic and a re-cook cannot silently produce different lyrics.
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
