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
from collections.abc import Iterable
from typing import Any

#: Caption languages worth asking for, best-first. Kept narrow deliberately: a lyrics track in a
#: language the aligner is not running on would align badly and score as a mismatch anyway.
#:
#: EXPLICIT CODES, NEVER A PATTERN. This was `"en.*,en"`, and the `en.*` glob is what earned YouTube's
#: `HTTP Error 429: Too Many Requests`. YouTube offers an auto-caption track translated into ~190
#: languages, and for a video whose audio is not English those appear under `en-<source>` codes
#: (`en-cs`, `en-de`, ...) — every one of which `en.*` matches. So one align job fired dozens of
#: timedtext requests back to back, got rate-limited part way through, and the tier came out degraded or
#: empty. It was waste on top of that: `find_caption_file` refuses translations and returns exactly ONE
#: file, so all but one of those downloads was discarded on arrival.
#:
#: `en-orig` is YouTube's marker for the ORIGINAL auto-caption language and is why it leads: on a video
#: that has it, it is the only track guaranteed not to be a translation. The regional variants follow
#: because `find_caption_file` accepts them and some uploads carry only `en-GB`.
DEFAULT_SUB_LANGS = "en-orig,en,en-US,en-GB"

#: Seconds to wait before EACH subtitle download. The one flag that directly answers a 429: the requests
#: are what YouTube rate-limits, and this is what stops them arriving as a burst. Small on purpose —
#: `--skip-download` means this whole call is a handful of metadata requests, so the added wall time is
#: about a second per track and it runs inside a cook that already takes minutes.
SUB_SLEEP_SEC = 1

#: Backoff for an HTTP error that is retryable, 429 included: exponential from 1s, capped at 30s. Without
#: it yt-dlp gives a rate-limited track exactly one chance and moves on, which is how a transient 429
#: became a permanently missing baseline.
HTTP_RETRY_SLEEP = "http:exp=1:30"

#: Retries for the extractor step itself, ahead of any track download. YouTube rate-limits the player
#: request too, and a 429 there loses every track at once rather than one.
EXTRACTOR_RETRIES = 3

# A WebVTT cue timing line: "00:01:23.456 --> 00:01:25.000 align:start position:0%".
# Hours are optional in the spec ("01:23.456"), so the leading group is conditional.
_VTT_TIME = r"(?:(\d{1,3}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})"
_VTT_CUE_RE = re.compile(rf"^{_VTT_TIME}\s*-->\s*{_VTT_TIME}")

#: Inline caption markup: <c.colorE5E5E5>, <00:00:12.345>, <b>, </i>. Karaoke-style per-word timing
#: tags are common in auto tracks and harmless to strip here — this tier only claims LINE timing.
_TAG_RE = re.compile(r"<[^>]*>")

#: Bracketed non-lyric annotations captioners add: [Music], [Applause], (chorus), ♪♪.
_ANNOTATION_RE = re.compile(r"^\s*(?:[\[(][^\])]*[\])]|[♪♫\s]+)\s*$")

#: How close two cues must sit in time for a prefix-extend to count as the SAME rolling line rather
#: than a coincidentally-repeated one. A rolling triplet's cues are contiguous or overlapping (the
#: 10ms hold cue butts straight against the next), so a small non-zero slack absorbs float rounding
#: without reaching across the gap to a chorus line that recurs later in the song.
_ROLLING_ADJACENCY_SEC = 0.5

#: Minimum WORD overlap for the SCROLL collapse below. YouTube's rolling window does not only grow, it
#: SCROLLS: once full, words drop off the FRONT as new ones append at the back, so a line is no longer a
#: growing prefix of the one before it — its HEAD instead repeats the previous line's TAIL. The
#: prefix-extend fold in `parse_vtt` cannot reach that shape.
#:
#: The length is load-bearing, not belt-and-braces. Every scroll pair on a real track is already
#: time-adjacent (`_ROLLING_ADJACENCY_SEC` cannot discriminate them), so the overlap length is the ONLY
#: signal separating a genuine scroll from a coincidence — one shared word at a line boundary is not
#: proof of a scroll. On the reference fixture the overlap curve is >=1 -> 106 pairs, >=2 -> 98,
#: >=3 -> 90, and the mode is 8 words, so 3 sits in a wide safe valley: it collapses every scroll pair
#: while sparing the single-word coincidences that a fold-on-any-shared-word rule would silently eat.
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

    Runs AFTER `parse_vtt`'s held/prefix-extend fold (which this deliberately leaves untouched, so the
    the rolling collapse is unchanged). For each time-adjacent pair whose incoming head repeats the
    running line's tail by at least `_SCROLL_MIN_OVERLAP_WORDS`, drop the overlapping head words and keep
    only the non-overlapping remainder as its own line. TRIMMING rather than merging preserves per-line
    windows, which the forced aligner and word-level highlighting both consume; merging the run into one
    line would also blow the `100 <= len(segs) <= 150` guard on a real track.

    Iterated to a FIXPOINT because a scrolled cue's own text can carry the repeated phrase TWICE (a real
    YouTube artifact where the phrase is held across the window boundary), which one left-to-right pass
    removes only one copy of. Each pass strictly removes words or changes nothing, so it converges in a
    couple of passes. The time-adjacency bound means a chorus line that genuinely recurs LATER in the
    song — separated in time — is never trimmed against an earlier one.

    `start`s are never advanced: on a real rolling track every incoming cue already begins at or after
    the previous line's end, so trimming the head does not create a line whose words predate its start.
    `parse_vtt` emits only {start, end, text}, so if a track ever DID overlap in time, the per-word
    timings needed to re-time a trimmed line would not be available at this seam — hence the assert
    in the test rather than silent timestamp repair here.
    """
    while True:
        result: list[dict[str, Any]] = []
        for seg in segs:
            if result and seg["start"] <= result[-1]["end"] + _ROLLING_ADJACENCY_SEC:
                overlap = _head_tail_overlap_words(result[-1]["text"], seg["text"])
                if overlap >= _SCROLL_MIN_OVERLAP_WORDS:
                    tail = " ".join(seg["text"].split()[overlap:]).strip()
                    if not tail:
                        # Wholly contained in the running line's tail (a pure re-hold): extend the window.
                        result[-1]["end"] = max(result[-1]["end"], seg["end"])
                        continue
                    result.append({"start": seg["start"], "end": seg["end"], "text": tail})
                    continue
            result.append(dict(seg))
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

    Handles the parts real YouTube tracks actually contain: an optional cue identifier line before the
    timing, cue settings after it, inline markup, and NOTE/STYLE/REGION blocks. Cues whose payload is
    only an annotation ([Music]) are dropped — they are not lyrics, and feeding them to a forced
    aligner corrupts the words on either side.

    A PAYLOAD ENDS AT A GENUINELY EMPTY LINE, not a whitespace-only one. WebVTT separates cue blocks
    with an empty line, but a whitespace-only line is legal *inside* a payload — and YouTube's auto
    tracks open the word-timed cue of each rolling triplet with exactly such a line. Terminating the
    payload scan on `.strip()` being falsy (rather than the line being literally empty) truncated at
    that first space-only line: `body` came out empty and the whole cue — the one carrying the per-word
    `<c>` timing — was silently discarded. `_clean_cue_text` already skips whitespace-only lines within
    a payload, so admitting them here is safe; the only change is where a cue block is judged to end.

    ROLLING AND HELD DUPLICATES ARE COLLAPSED. Caption tracks repeat a line across cues to hold it on
    screen (exact repeat), and YouTube's auto tracks *roll*: each cue repeats the previous cue's text
    and appends the next few words, so the same words arrive two or three times and the run grows by a
    prefix each step. Left in, a rolling track parses to ~2× the real lines — measured 236 where 121
    exist on a real 350s auto track — every one of which a forced aligner then has to place, and which
    the TV shows on the baseline-fallback path.

    Held and prefix-extend duplicates are collapsed HERE: when a cue's text is the previous line verbatim
    (held) OR extends it as a prefix (the window still growing), the run is folded into one line, keeping
    the longest (final) text and stretching its window over the whole run.

    A rolling window also SCROLLS: once full, words drop off the FRONT as new ones append, so a line is
    no longer a growing prefix of the one before — its HEAD instead repeats the previous line's TAIL, and
    neither fold arm above fires. That residual is trimmed in a separate pass by `_collapse_scroll_overlap`
    (applied to the returned segments) rather than in this loop, so the held/prefix collapse stays exactly
    as an earlier change shipped it.

    Both mechanisms are bounded by TIME-ADJACENCY — the new cue must begin at or before the running line's
    end plus a small slack — so a chorus line that genuinely recurs later in the song, separated in time,
    is never folded into an earlier one.

    (The old rationale here claimed the point was to stop the transcript "scoring its own text as far
    more repetitive"; that is wrong on its own terms — `agreement_score` is Jaccard over token SETS, so
    repetition cannot move it. The real beneficiaries are the forced aligner and the TV overlay.)
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
        # A cue block ends at a literally EMPTY line or the next cue's timing — NOT at a whitespace-only
        # line, which is legal inside a payload and opens the word-timed cue of a rolling triplet.
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
            # Held repeat (equal) or rolling extend (prefix): fold into the run, keep the longest text.
            out[-1]["text"] = body
            out[-1]["end"] = max(out[-1]["end"], end)
            continue
        out.append({"start": start, "end": end, "text": body})
    out.sort(key=lambda s: s["start"])
    # The fold above collapses HELD and PREFIX-EXTEND rolling duplicates. A scrolled window is neither —
    # its head repeats the previous line's tail — so a second, isolated pass trims that overlap.
    return _collapse_scroll_overlap(out)


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

    The three throttle/retry flags exist because this call is rate-limited in practice, not in theory:
    YouTube answers a burst of timedtext requests with `HTTP Error 429`, and a caption miss here is
    silent (the step swallows it and the tier just has no baseline). See the constants above.
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
        # Rate-limit survival. Ordered before -o purely for readability; yt-dlp does not care.
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


#: A TRANSLATED caption track. YouTube exposes machine translations of a caption track under the target
#: language with a long opaque suffix ("en-nP7Qs3xK9dQ"), alongside the original which is either plain
#: ("en") or explicitly marked ("en-orig").
_TRANSLATED_SUFFIX = re.compile(r"-[A-Za-z0-9_-]{8,}$")

#: A "translated FROM" marker: a lowercase language subtag after the target language, as in `en-cs`
#: (English translated from Czech). Short, so `_TRANSLATED_SUFFIX` never saw it — which is exactly the
#: hole this closes. The discriminator against a legitimate REGION variant is case, per BCP 47: a region
#: subtag is uppercase (`en-GB`, `pt-BR`) and a language subtag is lowercase (`en-cs`, `en-pt`).
_TRANSLATED_FROM = re.compile(r"-[a-z]{2,3}$")


def is_translated_track(name: str) -> bool:
    """Is this caption filename a machine TRANSLATION rather than the original language?

    Load-bearing for correctness, not tidiness. A Spanish song's automatic captions can be offered
    translated into English; as a baseline that text would be fluent, long enough to pass
    MIN_TOKENS_TO_COMPARE, and about the right song in the WRONG language — so it would not abstain, it
    would vote confidently against every correct candidate. That is worse than having no baseline.

    Two shapes, because YouTube uses two. The opaque-suffix form (`en-nP7Qs3xK9dQ`) was covered from the
    start; the `en-<lang>` form (`en-cs`) was not, and slipped through as a legitimate track because it
    is as short as a region variant. Case tells them apart — see the patterns above.
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
