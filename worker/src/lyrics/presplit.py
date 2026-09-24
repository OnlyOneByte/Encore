"""Pre-split auto-transcribed BLOB text into lyric-sized lines, before the length bounder runs.

WHY ONLY AUTO-TRANSCRIBED. Line structure is a property of the SOURCE, not of lyrics in general:
LRCLIB syncedLyrics arrives as one human-authored line per [mm:ss] stamp, LRCLIB plainLyrics as one
line per lyrics-site line, but ASR on the vocals stem arrives as whisper VAD chunks of up to ~30s —
several lyric lines collapsed into one blob. Only that tier needs re-lineating; running a splitter
over human-authored text can only damage it. The gate is `is_authoritative_text` (mirrors
`isAuthoritativeText` in src/lib/contract/lyrics/lyrics.ts): ASR is never authoritative, and an
AUTO-GENERATED caption track is demoted to `low` text confidence precisely so it lands on this side.

DIVISION OF LABOUR with karaoke-lyrics-processor (upstream, MIT, optional). Upstream is a
length-BOUNDER, not a phrase-finder: its recursive bisection glues a following clause's leading
conjunction onto the previous line's tail and rarely breaks on a sentence boundary. It is still worth
having for hard length bounding, an iteration cap, parenthesis isolation, and punctuation cleanup — so
this module finds the phrase boundaries first and hands it LINES instead of a blob. Upstream only ever
splits, never joins, so pre-broken lines are safe: it intervenes only on pieces still too long.

WHAT WHISPER ACTUALLY EMITS, since the rules below depend on it: it is NOT unpunctuated, but its full
stop lands at the END of a segment where there is nothing after it to split off, so the sentence rule
fires rarely and the comma/capitalisation rules do most of the work. A bare comma IS usually a real
lyric line break in practice (whisper inserts them at breath boundaries in sung vocals).

DEGRADES, never fails: if the package is absent, the boundary split still runs on its own and the
display layer's `LINE_MAX_CHARS` fallback still catches an over-long line.
"""

from __future__ import annotations

import importlib.util
import logging
import re
import sys
import types
from collections.abc import Callable
from dataclasses import replace
from typing import Any

from .grading import LyricsText, is_authoritative_text

#: Mirrors `LINE_MAX_CHARS` in src/lib/tv/lyrics.ts, the width of one TV reel row. Explicitly NOT
#: upstream's default of 36, which is measured against nothing here.
MAX_LINE_CHARS = 42

# The strongest lyric break there is, and upstream does not consider it at all. The trailing \s+ is
# required, or decimals ("3.5") split.
_SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+")

# Break BEFORE the conjunction, leaving the comma behind: a conjunction after a comma OPENS a clause.
_COMMA_CONJUNCTION_SPLIT = re.compile(
    r"(?<=,)\s+(?=(?:and|but|so|then|or|yet|nor|for|'?cause|because)\b)", re.IGNORECASE
)

#: Any comma, as a candidate break — used only to RE-PACK a piece that is still over-long.
_COMMA_SPLIT = re.compile(r"(?<=,)\s+")

#: A 3-char row wastes a reel line and reads worse than the long line it came from, so a candidate break
#: that would produce one is DECLINED.
_MIN_PIECE_CHARS = 8

#: Folded into a neighbour that still fits. DISTINCT from `_MIN_PIECE_CHARS`, which declines a break: two
#: reasonable rules in sequence can still strand a fragment, so this is a pass over the RESULT.
_MIN_LINE_CHARS = 12

# Whisper CAPITALISES a phrase start even without terminal punctuation, so case is a real boundary signal.
# Gated on a CLOSED SET rather than "any capital", because splitting every lowercase->Capital transition
# breaks proper nouns: openers are function words and imperatives, a class proper nouns are not in.
_LINE_OPENERS = frozenset(
    """
    i you we they he she it me my your our their his her its
    and but so then or nor yet for that this these those as
    when where while what who how why if though although since until
    all now no yes oh hey well just still every some
    don't won't can't ain't didn't couldn't wouldn't shouldn't isn't aren't wasn't
    it's there's here's let's that's what's i'm i'll i've i'd you're you'll we're they're
    take give come go tell say hold keep make let leave turn look see know feel wait
    """.split()
)

#: The candidate the closed set above filters.
_CAPITAL_OPENER = re.compile(r"(?<=[a-z,])\s+(?=([A-Z][\w']*))")

#: `(lines, max_chars) -> lines`. Injectable so the whole module tests without the upstream package.
LineBounder = Callable[[list[str], int], list[str]]


def _split_at_capital_openers(text: str) -> list[str]:
    """Break before a Capitalised word from `_LINE_OPENERS`. See that set for why it is closed."""
    out: list[str] = []
    last = 0
    for m in _CAPITAL_OPENER.finditer(text):
        if m.group(1).strip(".,!?;:'\"").lower() not in _LINE_OPENERS:
            continue
        left = text[last : m.start()].strip()
        if len(left) < _MIN_PIECE_CHARS or len(text) - m.end() < _MIN_PIECE_CHARS:
            continue
        out.append(left)
        last = m.end()
    tail = text[last:].strip()
    if tail:
        out.append(tail)
    return out


def _pack_at_commas(text: str, max_chars: int) -> list[str]:
    """Re-pack an over-long piece at BARE commas, greedily filling up to `max_chars`.

    Greedy fill rather than split-every-comma is what makes a bare comma safe to use at all: a clause
    that already fits a row stays whole rather than being shredded into two fragments that read worse.
    """
    if len(text) <= max_chars:
        return [text]
    parts = _COMMA_SPLIT.split(text)
    if len(parts) < 2:
        return [text]
    out: list[str] = []
    buf = ""
    for part in parts:
        cand = f"{buf} {part}" if buf else part
        too_long = len(cand) > max_chars
        both_substantial = len(buf) >= _MIN_PIECE_CHARS and len(part) >= _MIN_PIECE_CHARS
        if buf and too_long and both_substantial:
            out.append(buf)
            buf = part
        else:
            buf = cand
    if buf:
        out.append(buf)
    return out


def _coalesce_short(pieces: list[str], max_chars: int) -> list[str]:
    """Fold pieces below `_MIN_LINE_CHARS` into a neighbour, preferring FORWARD.

    Forward first because a stranded fragment is almost always the HEAD of the phrase after it (the
    rules that strand one are the openers, and an opener opens). Falls back to merging backwards,
    then to keeping the fragment: dropping it would delete words from the screen.
    """
    if len(pieces) < 2:
        return pieces
    out: list[str] = []
    rest = list(pieces)
    while rest:
        cur = rest.pop(0)
        if len(cur) >= _MIN_LINE_CHARS:
            out.append(cur)
        elif rest and len(cur) + 1 + len(rest[0]) <= max_chars:
            rest[0] = f"{cur} {rest[0]}"
        elif out and len(out[-1]) + 1 + len(cur) <= max_chars:
            out[-1] = f"{out[-1]} {cur}"
        else:
            out.append(cur)
    return out


def boundary_split(text: str, max_chars: int = MAX_LINE_CHARS) -> list[str]:
    """Break one blob at semantic boundaries, in descending order of how unambiguous they are.

    Two layers, because the evidence differs in strength:
      1. HARD boundaries, always taken: a sentence terminator, ", <conjunction>", and a Capitalised
         line-opener. Each of these marks a phrase start on its own, whatever the line's length.
      2. A GREEDY re-pack at bare commas, applied only to a piece still wider than a row. A comma is
         weaker evidence, so it is spent only where there is a problem to solve.
      3. A coalescing pass, folding away any fragment too short to hold a row (`_coalesce_short`).

    Coalescing runs PER SENTENCE, so it can never merge across a full stop. A short sentence is still a
    real lyric line — "faded out." deserves its own row and must not be glued to the sentence after it
    just because the pair would fit. Within a sentence the breaks come from weaker evidence (an opener,
    a comma), which is exactly the evidence worth reconsidering when it strands a fragment.

    Returns `[]` for empty input. A line with no boundary at all comes back whole — length bounding is
    upstream's job, and inventing a break we cannot justify is how you split a word in half.
    """
    out: list[str] = []
    for sentence in _SENTENCE_SPLIT.split((text or "").strip()):
        clauses: list[str] = []
        for clause in _COMMA_CONJUNCTION_SPLIT.split(sentence):
            clauses.extend(_split_at_capital_openers(clause))
        packed: list[str] = []
        for piece in clauses:
            cleaned = piece.strip()
            if cleaned:
                packed.extend(_pack_at_commas(cleaned, max_chars))
        out.extend(_coalesce_short(packed, max_chars))
    return out


_UNSET = object()
_KLP: Any = _UNSET

#: Probed once, reported at startup. THREE distinct statuses rather than one "bound nothing", or an
#: operator cannot tell "absent" (expected) from "installed but broken" (a regression).
_KLP_STATUS: str | None = None
_KLP_DETAIL: str = ""


def _load_klp() -> Any:
    """Import `KaraokeLyricsProcessor`, or None if it is absent or broken. Cached (import is not free).

    Also records WHY in `_KLP_STATUS`/`_KLP_DETAIL`. Absent (not installed) is told apart from broken
    (installed but raises on import) with `find_spec`, which answers without importing — the same
    probe-don't-infer rule `backends._module_available` uses.

    Registers a stub `textract` module first: upstream imports it at MODULE level even though it is
    only reachable from a .doc path this worker never takes, and the real package drags 25 further
    dependencies. Installed `--no-deps`; this stub stands in for the one import with no cheap real
    counterpart. See the note in requirements.txt.
    """
    global _KLP, _KLP_STATUS, _KLP_DETAIL
    if _KLP is not _UNSET:
        return _KLP
    if "textract" not in sys.modules:
        stub = types.ModuleType("textract")

        def _unavailable(*_a: Any, **_k: Any) -> Any:
            raise NotImplementedError("textract is stubbed: the worker never ingests .doc lyrics")

        stub.process = _unavailable  # type: ignore[attr-defined]
        sys.modules["textract"] = stub
    # find_spec answers WITHOUT importing, so a clean "absent" is not mistaken for "broken". It can itself
    # raise on a half-installed package, which IS broken, so that falls through to the import.
    try:
        spec_absent = importlib.util.find_spec("karaoke_lyrics_processor") is None
    except Exception:  # noqa: BLE001 — a raising find_spec means a broken install, resolved by the import
        spec_absent = False
    try:
        from karaoke_lyrics_processor import KaraokeLyricsProcessor
    except Exception as exc:  # noqa: BLE001 — absent or broken install: bound nothing, never fail the job
        _KLP = None
        if spec_absent:
            _KLP_STATUS, _KLP_DETAIL = "absent", "karaoke-lyrics-processor is not installed"
        else:
            _KLP_STATUS = "broken"
            _KLP_DETAIL = f"karaoke-lyrics-processor is installed but failed to import: {exc!r}"
    else:
        _KLP = KaraokeLyricsProcessor
        _KLP_STATUS, _KLP_DETAIL = "available", "karaoke-lyrics-processor imported"
    return _KLP


def klp_status() -> tuple[str, str]:
    """Load klp if not already, and return its resolved ``(status, detail)`` — one of available /
    absent / broken with a human-readable reason. The distinguishing observation an operator needs."""
    _load_klp()
    return _KLP_STATUS or "absent", _KLP_DETAIL


def klp_probe_line() -> str:
    """One startup line naming the resolved line-bounder state, mirroring the worker's other probed
    lines (backends, capabilities): probe, never infer; report loudly. `absent` is a normal degrade
    (the boundary split and the TV row fallback still run); `broken` is the one worth noticing."""
    status, detail = klp_status()
    return f"line-bounder (karaoke-lyrics-processor): {status} — {detail}"


def bound_lines(lines: list[str], max_chars: int = MAX_LINE_CHARS) -> list[str]:
    """Length-bound + clean already-broken lines via upstream. Returns `lines` unchanged if absent.

    Two upstream side effects are neutralised here: `__init__` calls `addHandler` on a MODULE-level
    logger, so instantiating once per song in a long-lived worker would accumulate handlers and
    duplicate every record to stderr (removed straight back off); `process()` copies to the clipboard,
    which raises on a headless container but is downgraded to a warning the CRITICAL level swallows.
    """
    klp = _load_klp()
    if klp is None or not lines:
        return lines
    try:
        proc = klp(
            log_level=logging.CRITICAL,
            input_lyrics_text="\n".join(lines),
            max_line_length=max_chars,
        )
        proc.logger.removeHandler(proc.log_handler)
        return [ln.strip() for ln in proc.process().splitlines() if ln.strip()] or lines
    except Exception:  # noqa: BLE001 — a bad bound is a missed improvement, not a failed job
        return lines


def _subdivide(seg: dict[str, Any], pieces: list[str]) -> list[dict[str, Any]]:
    """Spread one segment's [start, end] across its pieces, PROPORTIONALLY TO CHARACTER COUNT.

    Crude but strictly better than the 30s window it replaces: these bounds exist only to give the
    forced aligner a search window per line, and it re-times every word inside whatever window it gets.
    A tighter, roughly-right window is a better anchor than one correct window around four lines.
    """
    start, end = seg.get("start"), seg.get("end")
    numeric = isinstance(start, (int, float)) and isinstance(end, (int, float)) and end > start
    if not numeric:
        return [{"start": start, "end": end, "text": p, "words": []} for p in pieces]
    span = float(end) - float(start)  # type: ignore[arg-type]
    total = sum(len(p) for p in pieces) or 1
    out: list[dict[str, Any]] = []
    cum = 0
    for p in pieces:
        lo = float(start) + (cum / total) * span  # type: ignore[arg-type]
        cum += len(p)
        hi = float(start) + (cum / total) * span  # type: ignore[arg-type]
        out.append({"start": round(lo, 3), "end": round(hi, 3), "text": p, "words": []})
    return out


def _relineate_segments(text: LyricsText, max_chars: int, lineator: Callable[[str], list[str]]) -> LyricsText:
    """Re-lineate every text-only segment of `text` with `lineator`; return a NEW LyricsText.

    A segment that already carries WORD timings is passed through whole: splitting its text would
    orphan those timings from the words they belong to. `timing` is deliberately NOT changed:
    subdividing a line-timed segment yields more line-timed segments, and the tier's own claim about
    what it supplies is still true.

    Delegates to `_relineate_with_opens` (which also emits the `opens` map `bound_blob_text` needs, discarded
    here) so there is ONE copy of the passthrough/subdivide rule shared by the line-sync and
    aligner-window paths.
    """
    windows, _opens = _relineate_with_opens(text, lineator)
    # Copy-with-replacement, never a hand-listed constructor, which silently drops any field added to
    # LyricsText later — losing `role` turns a BASELINE into a candidate with nothing to grade against.
    return replace(text, segments=windows)


def split_blob_text(
    text: LyricsText, max_chars: int = MAX_LINE_CHARS, bounder: LineBounder | None = None
) -> LyricsText:
    """Re-lineate one NON-authoritative text: semantic boundary split THEN length bound.

    This is the auto-transcribed path — ASR and demoted auto-caption tracks — where line structure has
    to be INVENTED because the source never had lines (see the module header). `boundary_split` finds
    the phrase boundaries; the injected `bounder` (upstream, length-only) cleans up any piece still too
    long. Returns a NEW LyricsText; input untouched.
    """
    bound = bounder if bounder is not None else bound_lines
    return _relineate_segments(
        text, max_chars, lambda body: bound(boundary_split(body, max_chars), max_chars)
    )


def bound_blob_text(
    text: LyricsText, max_chars: int = MAX_LINE_CHARS, bounder: LineBounder | None = None
) -> LyricsText:
    """Length-bound one AUTHORITATIVE text WITHOUT rewriting its timing. New LyricsText.

    `segments` are LEFT UNCHANGED — they carry the source's OWN (human) line timings, published
    verbatim as `high` confidence by the line-sync fallback. Subdividing a segment to fit a TV row
    would invent an interior boundary from a CHARACTER COUNT that then ships labelled as the source's
    own timestamp. So bounding here produces only ALIGNER SEARCH WINDOWS (`align_windows`), never a
    change to `segments` — throwaway search hints, not published timing.

    Do NOT call `boundary_split`: its comma/opener/sentence rules rewrite line STRUCTURE, and
    rewriting a line a human wrote can only damage it. Each segment's existing human line is handed
    to upstream as-is; upstream only ever splits (never joins), so it touches a line only when it
    overflows a row. `is_authoritative_text` in `presplit_texts` is the fence routing text here
    versus to `split_blob_text`.

    When no segment overflows a row the windows equal `segments`, so `align_windows` is left None.
    """
    bound = bounder if bounder is not None else bound_lines
    lineator = lambda body: bound([body], max_chars)  # noqa: E731 — one-line adapter, matches call sites
    # Windows AND the opening index of each human segment in the SAME walk, so the index is a KNOWN fact
    # rather than re-derived downstream by float-equality, which strands every line after a 1e-6 miss.
    windows, opens = _relineate_with_opens(text, lineator)
    same = windows == list(text.segments)
    if same:
        return replace(text, align_windows=None, align_window_opens=None)
    return replace(text, align_windows=windows, align_window_opens=opens)


def _relineate_with_opens(
    text: LyricsText, lineator: Callable[[str], list[str]]
) -> tuple[list[dict[str, Any]], list[int]]:
    """Re-lineate every text-only segment and, in the same walk, record each segment's opening index.

    Mirrors `_relineate_segments` exactly, but also returns `opens`: for each input segment, the
    index in the output at which its window block begins. Emitting this map here makes the
    float-fragile reconstruction-by-matching-starts (`_opening_window_indices`) unnecessary.
    """
    windows: list[dict[str, Any]] = []
    opens: list[int] = []
    for seg in text.segments:
        if not isinstance(seg, dict):
            # Not a real segment, but still recorded so indices stay 1:1 with text.segments.
            opens.append(len(windows))
            continue
        opens.append(len(windows))
        body = seg.get("text")
        if seg.get("words") or not isinstance(body, str) or not body.strip():
            windows.append(seg)
            continue
        pieces = [p for p in lineator(body) if p.strip()]
        if len(pieces) <= 1:
            windows.append(seg)
            continue
        windows.extend(_subdivide(seg, pieces))
    return windows, opens


def presplit_texts(
    texts: list[LyricsText], max_chars: int = MAX_LINE_CHARS, bounder: LineBounder | None = None
) -> list[LyricsText]:
    """Length-bound every text tier; re-lineate ONLY the auto-transcribed ones.

    Two distinct jobs, split along `is_authoritative_text`: length bounding runs on EVERY tier (a
    human line can still overflow a TV row), semantic re-lineation runs ONLY where line structure was
    never present to begin with.

    Alternates get the SAME fence: `select_by_baselines` may publish an alternate, and presplit runs
    strictly BEFORE selection, so an unfenced alternate would reach the aligner unbounded if it won.
    Routed through the fence rather than `bound_blob_text` directly, so a future non-authoritative
    source with alternates is not mis-routed.
    """

    def _fence(t: LyricsText) -> LyricsText:
        return (
            bound_blob_text(t, max_chars=max_chars, bounder=bounder)
            if is_authoritative_text(t.text_source, t.text_confidence)
            else split_blob_text(t, max_chars=max_chars, bounder=bounder)
        )

    return [replace(_fence(t), alternates=[_fence(a) for a in t.alternates]) for t in texts]
