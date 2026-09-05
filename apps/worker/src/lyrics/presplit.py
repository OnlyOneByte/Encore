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

import logging
import re
import sys
import types
from dataclasses import replace
from typing import Any, Callable

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


def _load_klp() -> Any:
    """Import `KaraokeLyricsProcessor`, or None if it is not installed. Cached (import is not free).

    Registers a stub `textract` module first. Upstream imports textract at MODULE level even though it
    is only reachable from `read_doc_file`, a .doc path we never take — our text arrives in memory from
    an HTTP response or from whisper, never from a file. The real `textract-py3` would drag 25 further
    packages (SpeechRecognition, pdfminer.six, python-pptx, oletools + pcodedmp, cryptography, easygui,
    xlrd<2 …), so the package is installed `--no-deps` and this stands in for the one import that has
    no cheap real counterpart. See the note in requirements.txt.
    """
    global _KLP
    if _KLP is not _UNSET:
        return _KLP
    if "textract" not in sys.modules:
        stub = types.ModuleType("textract")

        def _unavailable(*_a: Any, **_k: Any) -> Any:
            raise NotImplementedError("textract is stubbed: the worker never ingests .doc lyrics")

        stub.process = _unavailable  # type: ignore[attr-defined]
        sys.modules["textract"] = stub
    try:
        from karaoke_lyrics_processor import KaraokeLyricsProcessor
    except Exception:  # noqa: BLE001 — absent or broken install: bound nothing, never fail the job
        _KLP = None
    else:
        _KLP = KaraokeLyricsProcessor
    return _KLP


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
        return [l.strip() for l in proc.process().splitlines() if l.strip()] or lines
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


def split_blob_text(
    text: LyricsText, max_chars: int = MAX_LINE_CHARS, bounder: LineBounder | None = None
) -> LyricsText:
    """Re-lineate one non-authoritative text's segments. Returns a NEW LyricsText; input untouched.

    A segment that already carries WORD timings is passed through whole. Splitting its text would
    orphan those timings from the words they belong to, and the case does not arise in practice
    anyway — MEASURED (lyrics/chain.py AsrSource): whisper `transcribe()` returns segment bounds and no
    word timings, so the blob tier is line-timed and the aligner is what produces words. Skipping
    rather than attempting a partition keeps a whole class of timing corruption out of reach.

    `timing` is deliberately NOT changed: subdividing a line-timed segment yields more line-timed
    segments, and the tier's own claim about what it supplies is still true.
    """
    bound = bounder if bounder is not None else bound_lines
    segments: list[dict[str, Any]] = []
    for seg in text.segments:
        if not isinstance(seg, dict):
            continue
        body = seg.get("text")
        if seg.get("words") or not isinstance(body, str) or not body.strip():
            segments.append(seg)
            continue
        pieces = bound(boundary_split(body, max_chars), max_chars)
        pieces = [p for p in pieces if p.strip()]
        if len(pieces) <= 1:
            segments.append(seg)
            continue
        segments.extend(_subdivide(seg, pieces))
    # Copy-with-replacement rather than a hand-listed constructor. Re-lineating changes SEGMENTS and
    # nothing else, so every other field must survive verbatim — and a hand-written list silently drops
    # whatever is added to LyricsText later. It already did: `role` was lost here, which turned a BASELINE
    # into a candidate on its way through and left the grader with nothing to grade against.
    return replace(text, segments=segments)


def presplit_texts(
    texts: list[LyricsText], max_chars: int = MAX_LINE_CHARS, bounder: LineBounder | None = None
) -> list[LyricsText]:
    """Re-lineate the auto-transcribed texts in an acquisition result; pass the rest through as-is."""
    return [
        t
        if is_authoritative_text(t.text_source, t.text_confidence)
        else split_blob_text(t, max_chars=max_chars, bounder=bounder)
        for t in texts
    ]
