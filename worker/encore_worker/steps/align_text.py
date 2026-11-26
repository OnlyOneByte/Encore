"""Text acquisition's own predicates, and the pinned re-time.

What a provider's payload is timed TO, read off the payload; and the re-time of a pasted or pinned text,
including which earlier candidates it withdraws. Design: docs/arch/05-worker.md §8.
"""

from __future__ import annotations

import difflib
import json
import os
from collections.abc import Collection, Sequence
from dataclasses import dataclass

from encore_worker.adapters import ports
from encore_worker.adapters.ports import InfraFault
from encore_worker.domain.document import Segment
from encore_worker.domain.lyrics.policy import Knob
from encore_worker.steps.records import (
    TIMING_LINE,
    TIMING_WORD,
    JobRef,
    TextRef,
)


class _Permanent(InfraFault):
    """A fault no retry can fix: a capability this box does not have. An `InfraFault`: no step declines it."""

    retryable = False


def _has_timings(cues: Sequence[Segment]) -> bool:
    """Did the provider return SYNCED lyrics, or a plain wall of text?

    `bool` excluded: `True` is an `int`, and a start of `True` is not a timestamp.
    """
    return any(
        isinstance(c.get("start"), (int, float)) and not isinstance(c.get("start"), bool) for c in cues
    )


def _has_word_spans(cues: Sequence[Segment]) -> bool:
    """Did the provider return WORD-level timings? LRCmux can, and so does an A2 LRC sheet.

    THE SEQUENCE TEST IS `measure._words`' ONE: `clean_segments` rewrites a word list as a TUPLE, so a
    `list`-only test could never be True. `str` and `bytes` are excluded.
    """
    return any(
        isinstance(c.get("words"), Sequence) and not isinstance(c.get("words"), (str, bytes)) and c["words"]
        for c in cues
    )


def _timing_of(provider: ports.LyricsProvider, cues: Sequence[Segment]) -> str | None:
    """What the returned text is timed to, read from the PAYLOAD rather than a provider's claim: a response
    tagged word-level whose lines carry no word spans is not word-level."""
    if _has_word_spans(cues):
        return TIMING_WORD
    if _has_timings(cues):
        return TIMING_LINE
    return None


def _provider_label(provider: ports.LyricsProvider) -> str:
    """The label reaching the decision trail: a multiplexer names its UPSTREAM when it has one, which is what
    makes a systematically bad source identifiable instead of anonymous."""
    upstream = getattr(provider, "last_source", None)
    return f"{provider.name}:{upstream}" if isinstance(upstream, str) and upstream else provider.name


#: A paste's label, and the one core's `LyricsTextSource` spells `manual` (`__main__._text_source_of`).
_MANUAL_LABEL = "manual"


#: A written document's top-level key for its TEXT, in full, when its `lines` do not carry all of it
#: (`_with_source_lines`). Not rendered: the TV's parser (`parseLyricsDoc`) reads `lines` alone.
_SOURCE_LINES = "sourceLines"

#: A seeded segment's key for the old line it is an untouched copy of (`seeded`), whose words are written back
#: verbatim (`_written`). Never in a written document.
_KEPT = "keptLine"


def _written(doc: dict[str, object], segments: Sequence[Segment]) -> dict[str, object]:
    """`doc` as written (`_with_source_lines`), each line the host left as it was keeping its old words
    verbatim, so a fix moves only what it changed, unless that span would overlap the lines beside it."""
    lines = doc.get("lines")
    kept = [(_norm(str(s.get("text") or "")), s.get(_KEPT)) for s in segments]
    if not isinstance(lines, list) or not any(old for _t, old in kept):
        return _with_source_lines(doc, segments)
    out = [line for line in lines]
    k = 0
    for n, line in enumerate(out):
        text = _norm(str(line.get("text") or "")) if isinstance(line, dict) else None
        m = next((x for x in range(k, len(kept)) if kept[x][0] == text), None)
        if m is None:
            continue
        k, old = m + 1, kept[m][1]
        if not isinstance(old, dict) or not (bounds := _timed_lines_of([old])):
            continue
        before = _timed_lines_of(out[n - 1 : n]) if n else []
        after = _timed_lines_of(out[n + 1 : n + 2])
        if (not before or before[0][2] <= bounds[0][1]) and (not after or bounds[0][2] <= after[0][1]):
            out[n] = {**line, "start": bounds[0][1], "end": bounds[0][2], "words": old["words"]}
    return _with_source_lines({**doc, "lines": out}, segments)


def _with_source_lines(doc: dict[str, object], segments: Sequence[Segment]) -> dict[str, object]:
    """`doc`, plus the text it was timed from (`_SOURCE_LINES`) when its lines lost some of it.

    The global engine's document holds only the lines it timed, so re-picking such a candidate re-timed a
    shorter text. Written only when something IS missing (docs/arch/04-alignment.md §11).
    """
    source = _source_texts(segments)
    lines = doc.get("lines")
    shown = [
        text
        for text in (
            str(line.get("text") or "").strip()
            for line in (lines if isinstance(lines, list) else [])
            if isinstance(line, dict)
        )
        if text
    ]
    return doc if shown == source else {**doc, _SOURCE_LINES: source}


def _source_texts(segments: Sequence[Segment]) -> list[str]:
    """A text's words, line by line, as a written document records them (`_SOURCE_LINES`): every segment's
    text, stripped, the empty ones left out. What `_stored_lines` reads back, so the two compare."""
    return [text for text in (str(segment.get("text") or "").strip() for segment in segments) if text]


@dataclass(frozen=True, slots=True)
class Superseded:
    """An EARLIER job's stored candidate for words this job's ladder refused (`superseded_candidates`)."""

    ref: str
    label: str
    timing: str
    language: str | None


def superseded_candidates(
    job: JobRef, refused: Sequence[TextRef], *, placed: Collection[str]
) -> list[Superseded]:
    """Every document in the lyrics store that an earlier job wrote for the WORDS of a text this job refused.

    Core ranks every job's candidates together and a REFUSED attempt writes nothing, so such a document kept
    its rank and went on showing. MATCHED ON THE WORDS, not the label alone, and a store that cannot be listed
    withdraws nothing. See docs/arch/04-alignment.md §11.
    """
    if not refused:
        return []
    wanted = {text.label: _source_texts(text.segments) for text in refused}
    try:
        names = sorted(os.listdir(os.path.join(job.media_dir, _LYRICS_STORE)))
    except OSError:
        return []
    found: list[Superseded] = []
    for name in names:
        ref = f"{_LYRICS_STORE}/{name}"
        if not name.startswith(f"{job.media_id}-") or not name.endswith(".json") or ref in placed:
            continue
        label = _pinned_label(ref, job.media_id)
        words = wanted.get(label)
        if words is None:
            continue
        stored, language, _why = _stored_lines(os.path.join(job.media_dir, ref))
        if stored == words:
            timing = TIMING_WORD if name.removesuffix(".json").endswith(f"-{TIMING_WORD}") else TIMING_LINE
            found.append(Superseded(ref=ref, label=label, timing=timing, language=language))
    return found


#: Where every lyrics document is stored, relative to the media volume (`steps.api.store_ref`).
_LYRICS_STORE = "derived/lyrics"


def _norm(text: str) -> str:
    return "".join(ch for ch in text.lower() if ch.isalnum() or ch.isspace()).strip()


def _timed_lines(path: str) -> list[tuple[str, float, float]]:
    """A stored document's lines with their bounds (the line's own, else its first and last word's); [] when
    the file is gone or unreadable, which only means there is nothing to seed from."""
    try:
        with open(path, encoding="utf-8") as handle:
            loaded = json.load(handle)
    except (OSError, ValueError):
        return []
    lines = loaded.get("lines") if isinstance(loaded, dict) else None
    return _timed_lines_of(lines if isinstance(lines, list) else [])


def _timed_lines_of(lines: Sequence[object]) -> list[tuple[str, float, float]]:
    out: list[tuple[str, float, float]] = []
    for line in lines:
        if not isinstance(line, dict) or not isinstance(line.get("text"), str):
            continue
        words = [w for w in line.get("words") or [] if isinstance(w, dict)]
        start = line.get("start")
        start = start if start is not None else (words[0].get("start") if words else None)
        end = line.get("end")
        end = end if end is not None else (words[-1].get("end") if words else None)
        if isinstance(start, (int, float)) and isinstance(end, (int, float)) and end > start:
            out.append((line["text"], float(start), float(end)))
    return out


def _worded(path: str) -> bool:
    """Whether a stored document carries word timings: an aligned one, not a provider's line-timed one."""
    try:
        with open(path, encoding="utf-8") as handle:
            loaded = json.load(handle)
    except (OSError, ValueError):
        return False
    lines = loaded.get("lines") if isinstance(loaded, dict) else None
    return any(isinstance(line, dict) and line.get("words") for line in lines or [])


def _pairs(a: Sequence[str], b: Sequence[str]) -> list[tuple[int, int]]:
    """The in-order pairing of `a` with `b` scoring most (equal 1, alike 0.5), not difflib's longest block,
    which on a chorus of repeated lines pairs a run one line early. A tie keeps the LATER pairing."""

    def weight(i: int, j: int) -> float | None:
        if a[i] == b[j]:
            return 1.0
        return 0.5 if difflib.SequenceMatcher(a=a[i], b=b[j]).ratio() >= 0.6 else None

    # best[i][j]: the most a[:i] and b[:j] can score.
    best = [[0.0] * (len(b) + 1) for _ in range(len(a) + 1)]
    for i in range(len(a)):
        for j in range(len(b)):
            w = weight(i, j)
            best[i + 1][j + 1] = max(best[i][j + 1], best[i + 1][j], -1.0 if w is None else best[i][j] + w)
    out: list[tuple[int, int]] = []
    i, j = len(a), len(b)
    while i and j:
        w = weight(i - 1, j - 1)
        if w is not None and best[i][j] == best[i - 1][j - 1] + w:
            out.append((i - 1, j - 1))
            i, j = i - 1, j - 1
        elif best[i][j] == best[i - 1][j]:
            i -= 1
        else:
            j -= 1
    return out[::-1]


def seed_times(
    texts: Sequence[str], old: Sequence[tuple[str, float, float]], *, line_timed: bool = False
) -> list[tuple[float, float | None] | None] | None:
    """Line bounds for a fix's lines, from the document it corrects; None for a line the aligner must find.
    A kept, edited or rewritten line (`_pairs`, or a same-size run between pairs) keeps its slot. An added
    line shares the gap a `line_timed` document left, or is decoded with the line before it (which keeps only
    its start) in an aligned one. A moved line (`_moved`) has no slot either, but its neighbours keep theirs
    whole. None when under half the lines pair. See docs/SERVER.md#lyrics-fixes.
    """
    paired: list[tuple[float, float | None] | None] = [None] * len(texts)
    a, b = [_norm(t) for t, _s, _e in old], [_norm(t) for t in texts]
    pairs = _pairs(a, b)
    i0 = j0 = 0
    for i, j in [*pairs, (len(a), len(b))]:
        if i - i0 == j - j0:
            for k in range(j - j0):
                paired[j0 + k] = old[i0 + k][1:]
        if i < len(a):
            paired[j] = old[i][1:]
        i0, j0 = i + 1, j + 1
    moved = _moved(a, b, pairs)
    for j in moved:
        paired[j] = None
    if sum(p is not None for p in paired) * 2 < len(texts):
        return None
    out = list(paired)
    j = 0
    while j < len(paired):
        if paired[j] is not None:
            j += 1
            continue
        stop = next((k for k in range(j, len(paired)) if paired[k] is not None), len(paired))
        before, after = paired[j - 1] if j else None, paired[stop] if stop < len(paired) else None
        gap = (before[1], after[0]) if before and after and before[1] is not None else None
        if line_timed and gap and gap[1] > gap[0]:
            step = (gap[1] - gap[0]) / (stop - j)
            out[j:stop] = [(gap[0] + n * step, gap[0] + (n + 1) * step) for n in range(stop - j)]
        elif before is not None and not moved.issuperset(range(j, stop)):
            out[j - 1] = (before[0], None)
        j = stop
    return out


def _moved(a: Sequence[str], b: Sequence[str], pairs: Sequence[tuple[int, int]]) -> set[int]:
    """The fix's lines whose ORDER changed: an unpaired line equal to an unpaired old one (the nearest), and
    every paired line it crossed. Their old slots are where the audio sang the old order, so none fits."""
    free = [i for i in range(len(a)) if i not in {i for i, _j in pairs}]
    out: set[int] = set()
    for j in sorted(set(range(len(b))) - {j for _i, j in pairs}):
        same = [i for i in free if a[i] == b[j]]
        if not same:
            continue
        i = min(same, key=lambda k: abs(k - j))
        free.remove(i)
        out |= {j, *(pj for pi, pj in pairs if (pi < i) != (pj < j))}
    return out


def seeded(job: JobRef, segments: tuple[Segment, ...]) -> tuple[tuple[Segment, ...], str | None]:
    """A paste's segments timed from core's `pinnedFrom`, the document it corrects, and their timing; the
    segments untouched and None (decoded blind) when there is no such document or it does not pair. A ref
    outside the lyrics store is ignored, as it is joined onto the media directory to be read."""
    ref = job.param_str("pinnedFrom")
    if not ref or ref.startswith("/") or "\\" in ref or ".." in ref.split("/"):
        return segments, None
    if not ref.startswith("derived/lyrics/") or not ref.endswith(".json"):
        return segments, None
    path = os.path.join(job.media_dir, ref)
    times = seed_times([str(s["text"]) for s in segments], _timed_lines(path), line_timed=not _worded(path))
    if times is None:
        return segments, None
    kept = _old_words(path)
    out: list[Segment] = []
    for s, t in zip(segments, times, strict=True):
        end = t[1] if t is not None else None
        old = kept.get((str(s["text"]).strip(), t[0], end)) if t is not None and end is not None else None
        out.append(s if t is None else {**s, "start": t[0], "end": t[1], **({_KEPT: old} if old else {})})
    return tuple(out), TIMING_LINE


def _old_words(path: str) -> dict[tuple[str, float, float], dict[str, object]]:
    """A stored document's word-timed lines by (EXACT text, start, end), the key `seed_times` slots them
    under: a fix that changes only case or punctuation must show the host's words, so it is not untouched."""
    try:
        with open(path, encoding="utf-8") as handle:
            loaded = json.load(handle)
    except (OSError, ValueError):
        return {}
    lines = loaded.get("lines") if isinstance(loaded, dict) else None
    out: dict[tuple[str, float, float], dict[str, object]] = {}
    for line in lines if isinstance(lines, list) else []:
        words = line.get("words") if isinstance(line, dict) else None
        if not isinstance(words, list) or not words or not isinstance(line.get("text"), str):
            continue
        bounds = _timed_lines_of([line])
        if bounds:
            out[(bounds[0][0].strip(), bounds[0][1], bounds[0][2])] = line
    return out


def _stored_lines(path: str) -> tuple[list[str], str | None, str]:
    """The line texts of a stored lyrics document, its language, and why it yielded none (for the trail).

    Keeps only the WORDS, a re-time existing because the stored timings are not wanted: `_SOURCE_LINES` when
    the document carries one, else `lines[].text`.
    """
    try:
        with open(path, encoding="utf-8") as handle:
            loaded = json.load(handle)
    except FileNotFoundError:
        return [], None, "the document is not on disk (evicted, or never written)"
    except (OSError, ValueError) as unreadable:
        return [], None, f"the document is unreadable ({type(unreadable).__name__})"
    if not isinstance(loaded, dict):
        return [], None, "the document is not a lyrics document"
    source = loaded.get(_SOURCE_LINES)
    lines = loaded.get("lines")
    texts = (
        [text.strip() for text in source if isinstance(text, str) and text.strip()]
        if isinstance(source, list)
        else [
            line["text"].strip()
            for line in (lines if isinstance(lines, list) else [])
            if isinstance(line, dict) and isinstance(line.get("text"), str) and line["text"].strip()
        ]
    )
    language = loaded.get("language")
    known = language if isinstance(language, str) and language else None
    return texts, known, "it carries no line with words"


def _pinned_label(ref: str, media_id: str) -> str:
    """The label a stored candidate was written under, read back off its ref — `_write`'s shape inverted,
    because a stored document carries no provenance of its own.

    `{media}-{label with ':' as '-'}{-knob…}-{timing}.json`: the timing and knob suffixes come off the end and
    the FIRST dash is the label's colon, a provider's upstream being able to contain dashes where the source
    cannot. Any other shape is `manual`.
    """
    name = ref.rsplit("/", 1)[-1].removesuffix(".json")
    if not name.startswith(f"{media_id}-"):
        return _MANUAL_LABEL
    rest = name.removeprefix(f"{media_id}-")
    timing = next((t for t in (TIMING_WORD, TIMING_LINE) if rest.endswith(f"-{t}")), None)
    if timing is None:
        return _MANUAL_LABEL
    timed = rest.removesuffix(f"-{timing}")
    for knob in reversed(list(Knob)):  # appended in `Knob` order, so peeled in reverse
        timed = timed.removesuffix(f"-{knob.value}")
    source, colon, variant = timed.partition("-")
    if not source:
        return _MANUAL_LABEL
    return f"{source}:{variant}" if colon and variant else source


def _place(media_dir: str, source_ref: str, target_ref: str) -> None:
    """Copy `source_ref` over `target_ref` atomically: a sibling temp file, then `os.replace`.

    A COPY, so the scratch original survives a `publish` re-run on resume. A source that IS its target stays.
    """
    if source_ref == target_ref:
        return
    source = os.path.join(media_dir, source_ref)
    target = os.path.join(media_dir, target_ref)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    staging = f"{target}.{os.getpid()}.part"
    with open(source, "rb") as src, open(staging, "wb") as dst:
        dst.write(src.read())
    os.replace(staging, target)
