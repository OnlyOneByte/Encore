"""Pre-split auto-transcribed BLOB text into lyric-sized lines, before the length bounder runs.

WHY ONLY AUTO-TRANSCRIBED. Line structure is a property of the SOURCE, not of lyrics in general:

    source                  arrives as
    LRCLIB syncedLyrics     one entry per [mm:ss] stamp — a human-authored lyric line (`parse_lrc`)
    LRCLIB plainLyrics      one line per lyrics-site line, kept by `.splitlines()`
                            (`plain_lyrics_to_segments`)
    ASR on the vocals stem  whisper `transcribe()` VAD chunks of up to ~30s — several lyric lines
                            collapsed into one blob

So the only tier that needs re-lineating is the one that never had lines to begin with. Running a
splitter over human-authored text can only damage it, which is why the gate is `is_authoritative_text`
(mirroring `isAuthoritativeText` in packages/shared/src/lyrics.ts) rather than a blanket pass: ASR is
never authoritative, and an AUTO-GENERATED caption track is demoted to `low` text confidence precisely
so it lands on this side of the same fence.

DIVISION OF LABOUR with karaoke-lyrics-processor (upstream, MIT). Upstream is a length-BOUNDER, not a
phrase-finder: `find_best_split_point` reaches for a comma NEAR THE MIDPOINT of an over-long span, then
" and ", then the middle word — i.e. recursive bisection. MEASURED 2026-09-03 against a synthetic
one-line blob at `max_line_length=36`, that yields `"until the morning came around, and"` and
`"every light behind me faded out, I"` — the NEXT line's leading conjunction glued onto the previous
line's tail — and it never breaks on a sentence boundary at all (`"never made a sound. So tell me"`).
Where a span has no comma near its midpoint it degrades to plain word-boundary bisection, which is no
better than the char-count fallback the TV overlay already had.

Upstream is still worth having for the parts it does well and that we would otherwise have to own:
hard length bounding with an iteration cap, stack-matched (and nested) parenthesis isolation, and
punctuation / Unicode-space cleanup. So we find the phrase boundaries and hand it LINES instead of a
blob. Upstream only ever splits, never joins, so feeding it pre-broken lines is safe: it intervenes
only on the pieces still too long, where a midpoint comma is a reasonable answer.

HOW WELL THIS WORKS, on the 171 over-long lines in this repo's own ASR artifacts: the semantic pass
alone brings 47% fully under the row budget with no bisection at all, and improves 71%. The rest are
genuinely structureless — vocalisations ("Na na na na …", 182 chars) and whisper's repetition failure
mode (one 636-char line repeating the same phrase eleven times) — where bisection is the only honest
answer and is also perfectly adequate.

A NOTE ON WHAT WHISPER ACTUALLY EMITS, since the rules below depend on it. It is NOT unpunctuated: 83%
of those over-long lines carry a `.`, `,`, `!` or `?`. But its full stop lands at the END of a segment,
where there is nothing after it to split off — so the sentence rule alone fires rarely, and the comma
and capitalisation rules do most of the work. An earlier version of this module assumed whisper returned
bare unpunctuated text and dismissed the bare comma as "a hint, not a boundary"; against the real corpus
that left 91% of over-long lines untouched.

DEGRADES, never fails. If the package is absent the boundary split still runs on its own, and the
display layer's `LINE_MAX_CHARS` fallback still catches an over-long line — so the dependency is
genuinely optional rather than nominally so.
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

from .chain import LyricsText, is_authoritative_text

#: Mirror of `LINE_MAX_CHARS` in apps/core/src/lib/tv/lyrics.ts — the width of one TV reel row.
#: NOT upstream's default of 36: 42 is measured against the actual row, and upstream's bisection
#: happens to get WORSE with more headroom (a 42-char budget produced a lopsided 41/23 split where a
#: 36-char one split evenly), which is further evidence bisection is the wrong primitive for finding
#: phrases. We give it pre-broken lines precisely so that weakness rarely matters.
MAX_LINE_CHARS = 42

# A sentence terminator followed by whitespace is the strongest lyric break there is, and upstream
# does not consider it at all. Requiring the trailing \s+ keeps decimals ("3.5") intact.
#
# MEASURED against 171 real over-long ASR lines in this repo's media dir: this fires far less often than
# it looks like it should, because whisper puts its full stop at the END of a segment, where there is
# nothing after it to split off. Mid-line terminators do occur; they are just not the common case.
_SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+")

# ", and …" → break BEFORE the conjunction, leaving the comma on the previous line. This is the single
# most visible upstream defect (3 of 9 lines in the measurement above), and it is unambiguous: a
# conjunction directly after a comma opens a new clause, it does not close the old one.
_COMMA_CONJUNCTION_SPLIT = re.compile(
    r"(?<=,)\s+(?=(?:and|but|so|then|or|yet|nor|for|'?cause|because)\b)", re.IGNORECASE
)

#: Any comma, as a candidate break — used only to RE-PACK a piece that is still over-long.
_COMMA_SPLIT = re.compile(r"(?<=,)\s+")

#: Never leave a fragment shorter than this. A 3-char row wastes a line of the reel and reads worse
#: than the long line it came from, so a candidate break that would produce one is declined.
_MIN_PIECE_CHARS = 8

#: Below this a piece does not deserve a row of its own, and is folded into a neighbour that still fits.
#: Distinct from `_MIN_PIECE_CHARS`, which declines a break: two rules firing in sequence can each be
#: individually reasonable and still leave a stranded fragment, so the fix has to be a pass over the
#: RESULT. MEASURED: without it, ", but" followed by a capital "I" yielded `"but still"` on its own row
#: with `"I lose my mind"` beneath — 24 chars that plainly wanted to be one line.
_MIN_LINE_CHARS = 12

# Whisper CAPITALISES a phrase start even when it omits the terminal punctuation, which makes case a
# real boundary signal and not a stylistic accident. MEASURED on the same corpus: of the over-long
# lines with no comma anywhere, 31 of 67 contain a lowercase→Capital transition, and it lands on the
# true lyric lines — "Don't you know | I still believe | That you will be here | And give me a sign".
#
# Gated on a CLOSED SET of openers rather than "any capital", because the false positives are all
# proper nouns: splitting every lowercase→Capital transition breaks "I bless the rains down in |
# Africa" and "my fancy house in | London town". Openers are function words and imperatives — a class
# that proper nouns are not in — so the set excludes exactly the wrong answers.
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

#: A lowercase (or comma) then whitespace then a Capitalised word — the candidate the set above filters.
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

    Greedy fill rather than split-every-comma, which is the distinction that makes a bare comma safe to
    use at all: "I walked the empty harbour road, until the morning came" fits a row, so it stays whole,
    whereas the same rule applied blindly would shred it into two fragments that read worse.

    MEASURED on 171 real over-long ASR lines: adding this took the share fully resolved to <=42 chars
    without any bisection from 3% to 33%, and the share we can improve at all from 8% to 54%. Whisper
    inserts commas at breath boundaries in sung vocals, so on real transcripts the comma IS usually the
    lyric line break — an earlier version of this module dismissed it as "a hint, not a boundary" on the
    strength of synthetic text, and the real corpus says otherwise.
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

    Forward first because a stranded fragment is almost always the HEAD of the phrase after it — the
    rules that strand one are the openers ("but still" + "I lose my mind"), and an opener opens. Falls
    back to merging backwards, then to keeping the fragment: a piece with nowhere to fit stays as it is,
    because dropping it would delete words from the screen.
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

#: Why `_load_klp` returned what it did — probed once, reported at startup. `None` until first load.
#: The three failure-adjacent facts the load can establish are kept DISTINCT here, because the caller
#: collapses them to one behaviour (bound nothing) and #444 filed this exact conflation as a defect:
#: without a status an operator cannot tell "package absent" from "stub broke" from "no line was
#: over-long", so a klp regression on the deploy box is invisible from the dev box where it is absent.
#:   • "available" — imported; `_KLP` is the class and bounding runs.
#:   • "absent"    — not installed (`find_spec` is None); bounding is a no-op, EXPECTED here.
#:   • "broken"    — installed but the import raised (a shim/version regression); bounding is a no-op,
#:                   and this is the one an operator must be able to see, because it looks like absent.
_KLP_STATUS: str | None = None
_KLP_DETAIL: str = ""


def _load_klp() -> Any:
    """Import `KaraokeLyricsProcessor`, or None if it is absent or broken. Cached (import is not free).

    Also records WHY it returned what it did in `_KLP_STATUS`/`_KLP_DETAIL` so absent, broken and a
    legitimate no-op stay three distinguishable observations rather than one silent `None` (#475).
    Absent (not installed) is told apart from broken (installed but raises on import) with `find_spec`,
    which answers without importing — the same probe-don't-infer rule `backends._module_available` uses.

    Registers a stub `textract` module first. Upstream imports textract at MODULE level even though it
    is only reachable from `read_doc_file`, a .doc path we never take — our text arrives in memory from
    an HTTP response or from whisper, never from a file. The real `textract-py3` would drag 25 further
    packages (SpeechRecognition, pdfminer.six, python-pptx, oletools + pcodedmp, cryptography, easygui,
    xlrd<2 …), so the package is installed `--no-deps` and this stands in for the one import that has
    no cheap real counterpart. See the note in requirements.txt.
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
    # Ask whether the package is even installed WITHOUT importing it, so a clean "absent" is not
    # mistaken for a "broken" import below. find_spec can itself raise on a half-installed package;
    # that is a broken install, not an absent one, so it falls through to the import which records it.
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
    absent / broken with a human-readable reason. The distinguishing observation #475 asks for."""
    _load_klp()
    # _load_klp always sets _KLP_STATUS before returning; the `or` only guards a caller that somehow
    # reads this before any load (there is none) so it never returns None to a formatter.
    return _KLP_STATUS or "absent", _KLP_DETAIL


def klp_probe_line() -> str:
    """One startup line naming the resolved line-bounder state, mirroring the worker's other probed
    lines (backends, capabilities): probe, never infer; report loudly. `absent` is a normal degrade
    (the boundary split and the TV row fallback still run); `broken` is the one worth noticing."""
    status, detail = klp_status()
    return f"line-bounder (karaoke-lyrics-processor): {status} — {detail}"


def bound_lines(lines: list[str], max_chars: int = MAX_LINE_CHARS) -> list[str]:
    """Length-bound + clean already-broken lines via upstream. Returns `lines` unchanged if absent.

    Two upstream side effects are neutralised here rather than tolerated:
      • `__init__` calls `addHandler` on a MODULE-level logger, so instantiating once per song in a
        long-lived worker would accumulate handlers and duplicate every record to stderr. The instance
        exposes the handler it added, so we take it straight back off.
      • `process()` copies the result to the clipboard. On a headless container pyperclip raises and
        upstream downgrades it to a warning, which the CRITICAL level then swallows.
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

    `lineator` maps one segment body to its output lines — the ONE place the authoritative and
    non-authoritative tiers differ. A segment that already carries WORD timings is passed through
    whole: splitting its text would orphan those timings from the words they belong to (MEASURED —
    whisper `transcribe()` returns segment bounds and no word timings, so this guards a case that
    should not arise). A segment that maps to one line or fewer is left as the SAME object.

    `timing` is deliberately NOT changed: subdividing a line-timed segment yields more line-timed
    segments, and the tier's own claim about what it supplies is still true.
    """
    segments: list[dict[str, Any]] = []
    for seg in text.segments:
        if not isinstance(seg, dict):
            continue
        body = seg.get("text")
        if seg.get("words") or not isinstance(body, str) or not body.strip():
            segments.append(seg)
            continue
        pieces = [p for p in lineator(body) if p.strip()]
        if len(pieces) <= 1:
            segments.append(seg)
            continue
        segments.extend(_subdivide(seg, pieces))
    # Copy-with-replacement rather than a hand-listed constructor. Re-lineating changes SEGMENTS and
    # nothing else, so every other field must survive verbatim — and a hand-written list silently drops
    # whatever is added to LyricsText later. It already did: `role` was lost here, which turned a BASELINE
    # into a candidate on its way through and left the grader with nothing to grade against.
    return replace(text, segments=segments)


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

    `segments` are LEFT UNCHANGED — they carry the source's OWN (human) line timings, and the line-sync
    fallback in `steps/lyrics.py` publishes them verbatim as `high` confidence. Subdividing a segment
    to fit a TV row invents an interior boundary from a CHARACTER COUNT, and that guess would then ship
    labelled as the source's own timestamp; nothing downstream could tell it apart. So bounding here
    produces only ALIGNER SEARCH WINDOWS (`align_windows`), never a change to `segments`.

    Do NOT call `boundary_split`: the semantic repacker's comma/opener/sentence rules rewrite line
    STRUCTURE, and rewriting a line a human wrote can only damage it. The upstream bounder "only ever
    splits, never joins, so feeding it pre-broken lines is safe: it intervenes only on the pieces still
    too long" — so each segment's existing (human) line is handed over as-is, and upstream touches it
    only when it overflows a row. The forced aligner re-times every word inside whatever window it gets
    (see `_subdivide`), so a tighter per-row window is a better anchor with no cost to honesty — the
    windows are throwaway search hints, not published timing. `is_authoritative_text` in
    `presplit_texts` is the fence that routes text here versus to `split_blob_text`.

    When no segment overflows a row the windows equal `segments`, so `align_windows` is left None and
    the aligner simply searches `segments`.
    """
    bound = bounder if bounder is not None else bound_lines
    lineator = lambda body: bound([body], max_chars)  # noqa: E731 — one-line adapter, matches call sites
    # Build the windows AND record where each human segment opens, in the SAME walk that produces them,
    # so the opening index of every line is a KNOWN fact rather than one re-derived downstream by
    # float-equality (issue #459: a single start that fails to match to 1e-6 strands every later line).
    # `opens[i]` is the index in `windows` of the first window contributed by `text.segments[i]`; a
    # segment passed through whole contributes exactly one, and a subdivided one opens at the block head.
    windows, opens = _relineate_with_opens(text, lineator)
    same = windows == list(text.segments)
    if same:
        return replace(text, align_windows=None, align_window_opens=None)
    return replace(text, align_windows=windows, align_window_opens=opens)


def _relineate_with_opens(
    text: LyricsText, lineator: Callable[[str], list[str]]
) -> tuple[list[dict[str, Any]], list[int]]:
    """Re-lineate every text-only segment and, in the same walk, record each segment's opening index.

    Mirrors `_relineate_segments` exactly (a segment with word timings or a <=1-piece body passes
    through as ONE window), but also returns `opens`: for each input segment, the index in the output
    at which its window block begins. This is the segment->window map `_opening_window_indices` used to
    reconstruct by matching starts to 1e-6 — emitting it here makes that reconstruction, and its
    float-fragility, unnecessary.
    """
    windows: list[dict[str, Any]] = []
    opens: list[int] = []
    for seg in text.segments:
        if not isinstance(seg, dict):
            # Not a real segment; still record where the (absent) block would open so indices stay
            # aligned 1:1 with text.segments for any caller pairing by position.
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

    Two distinct jobs, split along `is_authoritative_text`:
      • length bounding runs on EVERY tier (a human line can still overflow a TV row), and
      • semantic re-lineation runs ONLY where line structure was never present to begin with — ASR and
        the auto-caption tracks demoted to `low` confidence to land on that side of the fence.

    Alternates get the SAME fence. An alternate is a fully publishable text — `select_by_baselines`
    grades `[cand, *cand.alternates]` and may publish an alternate — and presplit runs strictly BEFORE
    selection, so any alternate that goes unfenced here reaches the aligner unbounded if it wins. Route
    each alternate through the fence (not `bound_blob_text` directly): they are all authoritative today,
    so the fence is a no-op on them, but hard-coding the authoritative branch would mis-route the first
    non-authoritative source that ever attaches alternates.
    """

    def _fence(t: LyricsText) -> LyricsText:
        return (
            bound_blob_text(t, max_chars=max_chars, bounder=bounder)
            if is_authoritative_text(t.text_source, t.text_confidence)
            else split_blob_text(t, max_chars=max_chars, bounder=bounder)
        )

    return [replace(_fence(t), alternates=[_fence(a) for a in t.alternates]) for t in texts]
